/**
 * pr-template-hydrate.mjs —— PR 可读标题提取与 `.github/pull_request_template.md` 实证回填。
 *
 * 从 workflow-helpers.mjs 拆出以严守单文件 <= 800 行红线，严格零第三方依赖（仅 Node 18+ 内置模块）。
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { assertNoAsciiControlChars } from './cli.mjs'
import { extractCriteria } from './criteria-lock.mjs'
import { parseDocFrontmatter } from './doc-frontmatter.mjs'
import { evaluateMasterPrdClosureState } from './doc-substantive.mjs'
import { evaluateObservationSubstance, formatArtifactEvidenceLines } from './empirical-artifacts.mjs'
import { EXIT } from './exit-codes.mjs'
import { formatWorkTitle } from './escalation.mjs'
import { posixPath, readTextSafe } from './git.mjs'
import { extractHeadlessSummary } from './markdown-scan.mjs'
import {
  renderCriteriaProgressTable,
  resolvePrimaryPlanDocCandidates,
  resolvePrimaryPlanDocOrder,
} from './master-criteria-sync.mjs'
import { PR_TEMPLATE_PATHS } from './platform-registry.mjs'

/**
 * 校验待发送到 GitHub 的多节 Markdown 正文未被折叠成单行/双行。
 * 若发现同一行内出现段中标题或总行数过少的多节标题，抛出 `BLOCKED_MALFORMED_MARKDOWN_BODY`。
 */
export function assertWellFormedMarkdownBody(body, label = 'markdown正文') {
  const text = String(body ?? '').replace(/\r\n/g, '\n').trim()
  if (!text) return
  const lines = text.split('\n')
  const nonEmptyLines = lines.filter((l) => l.trim().length > 0)
  let inFence = false
  let headingCount = 0
  for (const rawLine of lines) {
    if (/^\s*(?:```|~~~)/.test(rawLine)) { inFence = !inFence; continue }
    if (inFence) continue
    const lineNoCode = rawLine.replace(/`[^`\n]*`/g, '')
    const hMatches = lineNoCode.match(/(?:^|\s)#{2,6}\s+\S/g)
    if (hMatches) {
      headingCount += hMatches.length
      if (hMatches.length >= 2) {
        const err = new Error(`BLOCKED_MALFORMED_MARKDOWN_BODY: ${label} 出现同多行标题折叠到单行，请保留正常换行。`)
        err.code = 'BLOCKED_MALFORMED_MARKDOWN_BODY'
        err.exitCode = EXIT.FACT
        throw err
      }
    }
  }
  if (headingCount >= 2 && nonEmptyLines.length <= 2) {
    const err = new Error(`BLOCKED_MALFORMED_MARKDOWN_BODY: ${label} 存在 ${headingCount} 个章节标题但有效行数仅 ${nonEmptyLines.length} 行，疑似换行丢失。`)
    err.code = 'BLOCKED_MALFORMED_MARKDOWN_BODY'
    err.exitCode = EXIT.FACT
    throw err
  }
}

export function stripHtmlCommentsOutsideFences(md) {
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

export function extractMarkdownSectionText(text, headingPatterns = []) {
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

/**
 * PR 模板的分节标题——派生正文时的唯一来源。
 *
 * 模板里没有某段时，兜底正文必须用同一批词去分段，否则「模板缺段」和「模板换了说法」
 * 会产出两种不同的正文，读的人分不清哪份是准的。这份常量因此要跟
 * `.github/pull_request_template.md` 实际标题保持一致；`preflight` 对拍两者。
 */
export const PR_SECTION_TITLES = Object.freeze({
  summary: '变更摘要',
  issues: '关联 Issue 与文档',
  why: '改动理由',
  verify: '验证证据',
  impact: '影响面、风险与回滚方式',
  mergeAuth: '合并授权',
  selfCheck: '自查',
})

/**
 * 标题来源：人工改名（`caller`）还是从文档与 Issue 派生（`derived`）。
 *
 * 通道保留，来源要记账：事后有人问「这个标题哪来的」，答案得在记录里。
 */
export function resolveReadablePrTitleWithSource(repoRoot, ledger, explicitTitle = null) {
  const manual = String(explicitTitle ?? '').trim()
  if (manual) return { title: formatWorkTitle(manual, ledger?.caseType), titleSource: 'caller' }
  return { title: resolveReadablePrTitle(repoRoot, ledger, null), titleSource: 'derived' }
}

/** 优先按 `resolvePrimaryPlanDocOrder` 从关联规划文档（planBootstrap 优先 PRD，常规切片优先 SPEC/Todo）或 Issue 提取可读标题。 */
export function resolveReadablePrTitle(repoRoot, ledger, explicitTitle = null) {
  const manual = String(explicitTitle ?? '').trim()
  if (manual) return formatWorkTitle(manual, ledger?.caseType)
  const docCandidates = resolvePrimaryPlanDocCandidates(ledger)
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

/**
 * 渲染 PR「验证证据」：门禁表格 + 验证基线 + 结构化实证摘要与附件清单。
 * 实证附件与视觉核验那几行统一由 `empirical-artifacts.mjs` 产出，本函数只负责门禁表格。
 */
export function buildVerificationEvidenceSection({ evidence, ledger, shortHead, visualFilesChanged = [], visualVerifiedOnHead = false }) {
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
  if (e2eSummary) lines.push(`- **E2E 运行观察**：${e2eSummary}`)
  lines.push(...formatArtifactEvidenceLines({
    records: Array.isArray(evidence?.artifacts) ? evidence.artifacts : [],
    visual: buildVisualEvidenceView({ evidence, ledger, visualFilesChanged, visualVerifiedOnHead }),
  }))
  return lines.join('\n')
}

/**
 * 把 evidence.json 与账本里的界面核验结论汇成 `formatArtifactEvidenceLines` 需要的一层视图。
 *
 * 顺序即优先级：真附件 > 已落账观察 > 已落账环境阻塞 > 账本里的观察结论。
 * `visualVerifiedOnHead` 只用来区分「声明了核验」与「什么都没声明」，绝不拿它推断证据形态
 * ——一个布尔值证明不了附件存在，也替代不了观察原文。
 */
function buildVisualEvidenceView({ evidence, ledger, visualFilesChanged = [], visualVerifiedOnHead = false }) {
  const uiFiles = (Array.isArray(visualFilesChanged) ? visualFilesChanged : [])
    .map((f) => posixPath(String(f ?? '')).trim()).filter(Boolean).sort()
  if (uiFiles.length === 0) return null
  const stored = evidence?.visual && typeof evidence.visual === 'object' ? evidence.visual : null
  const records = Array.isArray(evidence?.artifacts) ? evidence.artifacts : []
  const view = {
    required: true,
    uiFiles,
    satisfiedBy: records.length > 0 ? 'artifacts' : null,
    observation: '',
    blockedReason: '',
    claimedNoProof: false,
  }
  if (view.satisfiedBy) return view
  const candidates = [
    { satisfiedBy: 'observation', text: String(stored?.observation ?? '').trim() },
    { satisfiedBy: 'blocked', text: String(stored?.blockedReason ?? '').trim() },
    { satisfiedBy: 'observation', text: String(ledger?.visualCheckEvidence ?? '').trim() },
  ]
  for (const cand of candidates) {
    if (!cand.text) continue
    const substance = evaluateObservationSubstance(cand.text)
    if (!substance.ok) continue
    view.satisfiedBy = cand.satisfiedBy
    if (cand.satisfiedBy === 'blocked') view.blockedReason = substance.text
    else view.observation = substance.text
    return view
  }
  view.claimedNoProof = Boolean(visualVerifiedOnHead)
  return view
}

function parseSectionHeaderLine(line) {
  const s = String(line ?? '')
  const h = /^(#{2,3})\s+(.+?)\s*$/.exec(s)
  if (h) return { kind: 'heading', level: h[1].length, title: h[2] }
  const b = /^\*\*([^*]+?)\*\*\s*(?:[:：]\s*)?$/.exec(s.trim())
  if (b) return { kind: 'bold', level: 4, title: b[1] }
  return null
}

function endsCurrentSection(outerHdr, nextHdr) {
  if (!nextHdr) return false
  if (outerHdr.kind === 'bold') return true
  return nextHdr.kind === 'heading' && nextHdr.level <= outerHdr.level
}

function matchHeadingCandidates(rawTitle, headingCandidates) {
  const clean = String(rawTitle ?? '')
    .replace(/^(?:\d+[.)、]\s*|[一二三四五六七八九十]+[、.)]\s*)/, '')
    .replace(/[:：]\s*$/, '')
    .trim()
  const low = clean.toLowerCase()
  return headingCandidates.some((cand) => (cand instanceof RegExp ? cand.test(clean) : String(cand).trim().toLowerCase() === low))
}

export function replaceSectionIfPresent(md, headingCandidates, newBody) {
  const lines = String(md ?? '').replace(/\r\n/g, '\n').split('\n')
  let inFence = false
  for (let i = 0; i < lines.length; i += 1) {
    if (/^\s*(?:```|~~~)/.test(lines[i])) { inFence = !inFence; continue }
    if (inFence) continue
    const hdr = parseSectionHeaderLine(lines[i])
    if (!hdr || !matchHeadingCandidates(hdr.title, headingCandidates)) continue
    let end = lines.length
    let innerFence = false
    for (let j = i + 1; j < lines.length; j += 1) {
      if (/^\s*(?:```|~~~)/.test(lines[j])) { innerFence = !innerFence; continue }
      if (!innerFence && endsCurrentSection(hdr, parseSectionHeaderLine(lines[j]))) { end = j; break }
    }
    const replacement = [lines[i], '', ...String(newBody ?? '').split('\n'), '']
    const nextLines = [...lines.slice(0, i), ...replacement, ...lines.slice(end)]
    return { matched: true, text: nextLines.join('\n') }
  }
  return { matched: false, text: md }
}

export function removeSectionIfPresent(md, headingCandidates) {
  const lines = String(md ?? '').replace(/\r\n/g, '\n').split('\n')
  let inFence = false
  for (let i = 0; i < lines.length; i += 1) {
    if (/^\s*(?:```|~~~)/.test(lines[i])) { inFence = !inFence; continue }
    if (inFence) continue
    const hdr = parseSectionHeaderLine(lines[i])
    if (!hdr || !matchHeadingCandidates(hdr.title, headingCandidates)) continue
    let end = lines.length
    let innerFence = false
    for (let j = i + 1; j < lines.length; j += 1) {
      if (/^\s*(?:```|~~~)/.test(lines[j])) { innerFence = !innerFence; continue }
      if (!innerFence && endsCurrentSection(hdr, parseSectionHeaderLine(lines[j]))) { end = j; break }
    }
    const nextLines = [...lines.slice(0, i), ...lines.slice(end)]
    return { matched: true, text: nextLines.join('\n') }
  }
  return { matched: false, text: md }
}

function removeSectionByHeading(md, headingTitle) {
  let cur = md
  const target = [String(headingTitle).trim()]
  while (true) {
    const r = removeSectionIfPresent(cur, target)
    if (!r.matched) break
    cur = r.text
  }
  return cur
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

function dedupRawBodyIssueRefs(rawBody, knownIssueNums = []) {
  const seen = new Set(knownIssueNums.map(Number).filter((n) => Number.isInteger(n) && n > 0))
  const out = []
  for (const line of String(rawBody ?? '').replace(/\r\n/g, '\n').split('\n')) {
    const m = /^\s*(?:fixes|closes|resolves|part\s+of)\s+#(\d+)\s*$/i.exec(line)
    if (m) {
      const n = Number(m[1])
      if (seen.has(n)) continue
      seen.add(n)
    }
    out.push(line)
  }
  return out.join('\n').trim()
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
  rawBody = '',
} = {}) {
  if (rawBody) assertNoAsciiControlChars(String(rawBody), 'PR rawBody')
  const shortHead = String(currentHead ?? '').slice(0, 7) || 'unknown'
  const specRel = ledger?.specFile ?? ledger?.archivedSpecFile
  const todoRel = ledger?.todoFile ?? ledger?.archivedTodoFile
  const prdRel = ledger?.prdFile ?? ledger?.archivedPrdFile
  const specText = repoRoot && specRel && existsSync(join(repoRoot, specRel)) ? readTextSafe(join(repoRoot, specRel)) : ''
  const todoText = repoRoot && todoRel && existsSync(join(repoRoot, todoRel)) ? readTextSafe(join(repoRoot, todoRel)) : ''
  const prdText = repoRoot && prdRel && existsSync(join(repoRoot, prdRel)) ? readTextSafe(join(repoRoot, prdRel)) : ''
  const prdIssueNum = Number(parseDocFrontmatter(prdText).data?.issue)
  const masterClosure = (repoRoot && prdRel)
    ? evaluateMasterPrdClosureState(repoRoot, prdRel, { currentSpecRel: specRel, currentTodoRel: todoRel })
    : null
  const keepOpenMasterIssue = (n) => {
    if (ledger?.planBootstrap === true) return true
    if (!masterClosure?.applies || !masterClosure?.isMasterPrd) return false
    if (masterClosure.state === 'ready-auto-close' || masterClosure.state === 'already-archived') return false
    return Number(n) === prdIssueNum
  }
  const uniqueLinkedIssues = [...new Set(
    (ledger?.linkedIssues ?? []).map(Number).filter((n) => Number.isInteger(n) && n > 0),
  )]
  const fixesLine = uniqueLinkedIssues
    .map((n) => (keepOpenMasterIssue(n) ? `Part of #${n}` : `Fixes #${n}`))
    .join('\n') || '无（独立变更任务）'
  const bootstrapDocs = ledger?.planBootstrap
    ? (Array.isArray(changedFiles) ? changedFiles.filter((f) => /^docs\/(?:prd|specs|todo)\/.*\.md$/.test(posixPath(f))) : [])
    : []
  const docLinks = [...new Set([specRel, todoRel, prdRel, ...bootstrapDocs].filter(Boolean))]
  const docSummary = docLinks.length > 0 ? docLinks.map((p) => `\`${p}\``).join('、') : `无（Case ${ledger?.caseType ?? 3}）`
  const pfTag = `<!-- pf-state:${JSON.stringify({ taskId, action: 'pr-body', branch: ledger?.branch ?? null, headSha: currentHead || null })} -->`
  const readableTitle = resolveReadablePrTitle(repoRoot, ledger)

  const docByKind = { prd: prdText, spec: specText, todo: todoText }
  const orderedTexts = resolvePrimaryPlanDocOrder(ledger).map((k) => docByKind[k]).filter(Boolean)
  const primaryGoalDoc = orderedTexts[0] ?? ''
  const specGoalBullets = extractMeaningfulBullets(extractMarkdownSectionText(primaryGoalDoc, [/(?:目标|范围|概述|要解决的问题|背景|产品目标|summary|overview|goal|motivation|background|context|problem)/i]), 3)
  const todoOutcomeBullets = ledger?.planBootstrap === true
    ? []
    : extractMeaningfulBullets(extractMarkdownSectionText(todoText, [/(?:完成后的记录|实际结果|成果|results?|outcomes?|summary|notes)/i]), 3)
  const headlessFallback = (todoOutcomeBullets.length === 0 && specGoalBullets.length === 0)
    ? (() => {
        const rawDoc = primaryGoalDoc || specText || todoText || prdText
        const bodyBullets = extractMeaningfulBullets(parseDocFrontmatter(rawDoc).body || rawDoc, 2)
        if (bodyBullets.length > 0) return bodyBullets
        const hl = extractHeadlessSummary(rawDoc, { maxLength: 180 })
        return hl ? [hl] : []
      })()
    : []
  const effectiveGoalBullets = specGoalBullets.length > 0 ? specGoalBullets : headlessFallback
  const primaryCriteria = (() => {
    for (const txt of orderedTexts) {
      const list = extractCriteria(txt)
      if (list.length > 0) return list
    }
    return []
  })()
  const criteriaProgress = renderCriteriaProgressTable(primaryCriteria)
  const effectiveImpl = String(implementerDisplay ?? actorDisplay ?? '').trim()
  const implFragment = effectiveImpl ? `，实施人：${effectiveImpl}` : ''
  const summaryText = [
    `- **${readableTitle}**（任务 \`${taskId}\`${implFragment}，涉及 ${changedFiles.length} 个文件）`,
    ...todoOutcomeBullets.map((b) => `- ${b}`),
    ...(todoOutcomeBullets.length === 0 ? effectiveGoalBullets.map((b) => `- ${b}`) : []),
    ...(criteriaProgress.block ? ['', `- **验收进度**：${criteriaProgress.summaryLine}`, '', criteriaProgress.block] : []),
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
  const rollbackText = `- 回滚基线：\`${String(ledger?.baseSha ?? '').slice(0, 7) || ledger?.baseBranch || 'HEAD'}\`（反向提交 \`git revert\` 并重跑完整门禁）`
  const mergeAuthText = policy?.independentReviewRequired === false
    ? '- 低风险纯文档改动：门禁绿灯可直接合入'
    : '- 独立审查 `fail` 为空且 CI 绿灯后由审查者合入（审查结论以独立评论记录；若含弱化门禁须人工确认）'

  const verifyPassed = Boolean(ledger?.lastVerifyExitCode === 0 && (!currentHead || ledger?.verifiedHead === currentHead))
  const templateCandidates = repoRoot
    ? PR_TEMPLATE_PATHS.map((rel) => join(repoRoot, ...rel.split('/')))
    : []
  const tplPath = templateCandidates.find((p) => existsSync(p)) ?? ''
  const tplRaw = tplPath ? readTextSafe(tplPath) : null
  if (!tplRaw) {
    // 兜底正文用与模板同一份标题常量分段：模板缺段时不该另起一套说法。
    const fallbackRendered = [
      `## ${PR_SECTION_TITLES.summary}`, '', summaryText,
      '', `## ${PR_SECTION_TITLES.why}`, '', whyText,
      '', `## ${PR_SECTION_TITLES.issues}`, '', fixesLine,
      '', `## ${PR_SECTION_TITLES.impact}`, '', riskLines,
      '', `## ${PR_SECTION_TITLES.verify}`, '', verifyText,
      '', pfTag,
    ].join('\n')
    assertWellFormedMarkdownBody(fallbackRendered, 'PR 模板兜底正文')
    return fallbackRendered
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
  let matchedCount = 0
  for (const [headings, content] of sectionUpdates) {
    const r = replaceSectionIfPresent(body, headings, content)
    body = r.text
    if (r.matched) matchedCount += 1
  }
  const cleanRawBody = dedupRawBodyIssueRefs(rawBody, uniqueLinkedIssues)
  if (matchedCount === 0) {
    const fallbackAppend = [
      `## ${PR_SECTION_TITLES.summary}`, '', summaryText,
      '', `## ${PR_SECTION_TITLES.issues}`, '', fixesLine,
      '', `## ${PR_SECTION_TITLES.verify}`, '', verifyText,
      ...(cleanRawBody ? ['', cleanRawBody] : []),
    ].join('\n')
    body = `${body.trimEnd()}\n\n${fallbackAppend}`
  } else if (cleanRawBody && !body.includes(cleanRawBody)) {
    body = `${body.trimEnd()}\n\n${cleanRawBody}`
  }
  body = updateChecklistByEvidence(body, { verifyPassed, finalized: Boolean(ledger?.finalized), hasNoSecrets: verifyPassed })
  const rendered = `${body.replace(/\n{3,}/g, '\n\n').trimEnd()}\n\n${pfTag}\n`
  assertNoAsciiControlChars(rendered, 'PR 模板渲染正文')
  assertWellFormedMarkdownBody(rendered, 'PR 模板渲染正文')
  return rendered
}
