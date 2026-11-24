/**
 * issue-template-hydrate.mjs —— Issue 模板水合与本地/通用远端结构化降级（零模板占位、零空洞套话与零字面量 `\n` 泄漏）。
 *
 * 复用 `pr-template-hydrate.mjs` 的围栏外 HTML 注释剥离与节替换逻辑，尊重宿主仓库自定义
 * `.github/ISSUE_TEMPLATE/`，在无模板、local-only 或 generic-git 下安全水合；缺项留给下游 `issue-quality.mjs` 统一拦截。
 */

import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { assertNoAsciiControlChars } from './cli.mjs'
import { posixPath, readTextSafe } from './git.mjs'
import { removeSectionIfPresent, replaceSectionIfPresent, stripHtmlCommentsOutsideFences } from './pr-template-hydrate.mjs'

export function normalizeEscapedNewlines(text) {
  const s = String(text ?? '').replace(/\r\n/g, '\n')
  return s.replace(/(?<![A-Za-z]:)\\n/g, '\n')
}

function stripYamlFrontmatter(md) {
  return String(md ?? '').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n*/, '')
}

function normalizeKind(kind, caseType) {
  const k = String(kind ?? '').trim().toLowerCase()
  if (k === 'bug' || k === 'fix' || Number(caseType) === 2) return 'bug'
  return 'feature'
}

export function resolveIssueTemplate(repoRoot, kind = 'feature', opts = {}) {
  if (opts?.templatePath) {
    const abs = join(repoRoot, opts.templatePath)
    const raw = readTextSafe(abs)
    if (raw) return { path: posixPath(opts.templatePath), raw }
  }
  if (!repoRoot) return null
  const dir = join(repoRoot, '.github', 'ISSUE_TEMPLATE')
  if (!existsSync(dir)) return null
  let entries = []
  try {
    entries = readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isFile() && /\.md$/i.test(d.name))
      .map((d) => d.name)
      .sort()
  } catch {
    return null
  }
  if (entries.length === 0) return null

  const normKind = normalizeKind(kind)
  const preferred = normKind === 'bug'
    ? ['bug_report.md', 'bug.md', 'defect.md']
    : ['feature_request.md', 'feature.md', 'enhancement.md']
  for (const name of preferred) {
    if (entries.includes(name)) {
      const raw = readTextSafe(join(dir, name))
      if (raw) return { path: `.github/ISSUE_TEMPLATE/${name}`, raw }
    }
  }
  const keywordRe = normKind === 'bug' ? /\bbug\b|缺陷|故障/i : /\bfeat|feature|需求|特性|改进/i
  for (const name of entries) {
    const raw = readTextSafe(join(dir, name))
    if (raw && keywordRe.test(`${name}\n${raw.slice(0, 400)}`)) {
      return { path: `.github/ISSUE_TEMPLATE/${name}`, raw }
    }
  }
  const fallbackRaw = readTextSafe(join(dir, entries[0]))
  return fallbackRaw ? { path: `.github/ISSUE_TEMPLATE/${entries[0]}`, raw: fallbackRaw } : null
}

function formatCriteriaLines(fields) {
  const raw = Array.isArray(fields?.criteria) ? fields.criteria.filter((c) => String(c ?? '').trim()) : []
  if (raw.length === 0) return ''
  return raw.map((c, idx) => {
    const t = String(c).trim()
    return /^- \[[ xX]\]\s+C\d+\b/.test(t) ? t : `- [ ] C${idx + 1}: ${t}`
  }).join('\n')
}

function normalizeFilesList(rawFiles) {
  if (Array.isArray(rawFiles)) {
    return rawFiles.map((f) => posixPath(String(f ?? '')).trim()).filter(Boolean)
  }
  if (typeof rawFiles === 'string' && rawFiles.trim()) {
    return rawFiles.split(/[\s,]+/).map((f) => posixPath(f).trim()).filter(Boolean)
  }
  return []
}

function formatDocRefsValue(rawDocRefs) {
  if (Array.isArray(rawDocRefs)) {
    return rawDocRefs
      .map((p) => String(p ?? '').trim())
      .filter(Boolean)
      .map((p) => (/^[-*]/.test(p) || p.includes('`') ? p : `- \`${posixPath(p)}\``))
      .join('\n')
  }
  return normalizeEscapedNewlines(String(rawDocRefs ?? '')).trim()
}

function buildSectionValues(fields = {}) {
  const metaParts = [
    fields.caseType ? `Case ${fields.caseType}` : null,
    fields.source ? `source=${fields.source}` : null,
    fields.tier ? `tier=${fields.tier}` : null,
    fields.taskId ? `task=${fields.taskId}` : null,
    fields.category ? `category=${fields.category}` : null,
    fields.severity ? `severity=${String(fields.severity).toLowerCase()}` : null,
  ].filter(Boolean)

  const summary = normalizeEscapedNewlines(
    fields.summary || fields.context || fields.problem || '',
  ).trim()
  const actualLines = [metaParts.length > 0 ? metaParts.join(' | ') : null, summary || null].filter((x) => x !== null)
  if (fields.findingsSummary) actualLines.push('', normalizeEscapedNewlines(fields.findingsSummary).trim())
  if (fields.baseline) actualLines.push('', `- 已核实基线：${normalizeEscapedNewlines(fields.baseline).trim()}`)
  if (fields.limitations) actualLines.push(`- 已知局限：${normalizeEscapedNewlines(fields.limitations).trim()}`)

  const expected = normalizeEscapedNewlines(fields.expected || '').trim()

  const reproParts = []
  if (fields.repro) reproParts.push(normalizeEscapedNewlines(fields.repro).trim())
  if (fields.reproEvidence) reproParts.push(`- 最小复现：${normalizeEscapedNewlines(fields.reproEvidence).trim()}`)
  if (fields.pocCommand) reproParts.push(`- 复现命令：\`${String(fields.pocCommand).trim()}\``)

  const files = normalizeFilesList(fields.files)
  const docRefsFormatted = formatDocRefsValue(fields.docRefs)
  const scopeLines = []
  if (fields.scope) scopeLines.push(normalizeEscapedNewlines(fields.scope).trim())
  if (fields.taskId) scopeLines.push(`- 任务标识：\`${fields.taskId}\``)
  if (docRefsFormatted) scopeLines.push(`- 关联文档：${docRefsFormatted.replace(/\n+/g, '、')}`)
  if (files.length > 0) {
    scopeLines.push(`- 涉及路径：${files.slice(0, 12).map((f) => `\`${f}\``).join('、')}`)
  }

  const impactLines = []
  if (fields.impact) impactLines.push(normalizeEscapedNewlines(fields.impact).trim())
  if (fields.severityBasis) impactLines.push(`- 严重度依据：${normalizeEscapedNewlines(fields.severityBasis).trim()}`)
  if (impactLines.length > 0 && files.length > 0 && !impactLines.some((l) => files.some((f) => l.includes(f)))) {
    impactLines.push(`- 涉及路径：${files.slice(0, 12).map((f) => `\`${f}\``).join('、')}`)
  }
  const combinedImpact = impactLines.length > 0
    ? [...impactLines, ...(fields.scope ? [normalizeEscapedNewlines(fields.scope).trim()] : [])].join('\n').trim()
    : scopeLines.join('\n').trim()

  const extraLines = []
  if (fields.rootCause) extraLines.push(`- 根因与影响：${normalizeEscapedNewlines(fields.rootCause).trim()}`)
  if (fields.extra) extraLines.push(normalizeEscapedNewlines(fields.extra).trim())
  if (fields.stopLossPacket) {
    const p = fields.stopLossPacket
    if (p.reason) extraLines.push(`- 停损判定：${p.reason}`)
    if (Array.isArray(p.hotspotFiles) && p.hotspotFiles.length > 0) {
      extraLines.push(`- 热点文件：${p.hotspotFiles.map((f) => `\`${posixPath(f)}\``).join('、')}`)
    }
    if (Array.isArray(p.repeatedFingerprints) && p.repeatedFingerprints.length > 0) {
      extraLines.push(`- 重复指纹：${p.repeatedFingerprints.map((fp) => `\`${fp}\``).join('、')}`)
    }
    if (p.docPlanBridge) extraLines.push(`- 交接命令：\`${p.docPlanBridge}\``)
  }

  return {
    actual: actualLines.join('\n').trim(),
    expected,
    repro: reproParts.join('\n').trim(),
    scope: scopeLines.join('\n').trim(),
    impact: combinedImpact,
    extra: extraLines.join('\n').trim(),
    criteria: formatCriteriaLines(fields),
    environment: normalizeEscapedNewlines(fields.environment || '').trim(),
    alternatives: normalizeEscapedNewlines(fields.alternatives || fields.rootCause || '').trim(),
    outOfScope: normalizeEscapedNewlines(fields.outOfScope || '').trim(),
    docRefs: docRefsFormatted,
  }
}

function buildFallbackIssueBody(fields = {}, sec) {
  const lines = []
  if (sec.actual) lines.push('## 背景与现象', '', sec.actual)
  if (sec.impact) lines.push('', '## 影响面与严重度', '', sec.impact)
  if (sec.scope && sec.scope !== sec.impact) lines.push('', '## 范围与依据', '', sec.scope)
  if (sec.extra) lines.push('', '## 根因与影响', '', sec.extra)
  if (sec.repro) lines.push('', '## 复现线索', '', sec.repro)
  if (sec.expected) lines.push('', '## 期望与方案', '', sec.expected)
  else if (sec.alternatives && !sec.extra) lines.push('', '## 期望与方案', '', sec.alternatives)
  if (sec.criteria) lines.push('', '## 验收标准', '', sec.criteria)
  if (sec.outOfScope) lines.push('', '## 不在本次范围', '', sec.outOfScope)
  if (sec.docRefs) lines.push('', '## 关联的设计产物', '', sec.docRefs)
  if (fields.nextStep) lines.push('', '## [NEXT STEP]', '', `[NEXT STEP] ${String(fields.nextStep).trim()}`)
  const out = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()
  return out ? `${out}\n` : ''
}

/**
 * 水合工单正文：优先读取 `.github/ISSUE_TEMPLATE/` 模板（剥离 frontmatter 与围栏外 HTML 注释），
 * 填充真实结构化字段并剥离未填占位与空节，绝不捏造套话；无模板或 0 匹配时结构化降级并保留 `rawExplicit`。
 */
export function hydrateIssueBody(repoRoot, kind = 'feature', fields = {}, opts = {}) {
  const rawExplicit = typeof fields?.rawBody === 'string' ? normalizeEscapedNewlines(fields.rawBody).trim() : ''
  if (rawExplicit) assertNoAsciiControlChars(rawExplicit, 'Issue rawBody')
  if (fields?.summary) assertNoAsciiControlChars(String(fields.summary), 'Issue summary')
  if (rawExplicit && /^##\s+/m.test(rawExplicit) && !opts.forceTemplate) {
    return `${stripHtmlCommentsOutsideFences(rawExplicit).replace(/\n{3,}/g, '\n\n').trim()}\n`
  }

  const effectiveFields = rawExplicit && !fields.summary
    ? { ...fields, summary: rawExplicit }
    : fields
  const normKind = normalizeKind(kind, effectiveFields.caseType)
  const sec = buildSectionValues(effectiveFields)
  const tpl = opts.noTemplate ? null : resolveIssueTemplate(repoRoot, normKind, opts)
  if (!tpl) return buildFallbackIssueBody(effectiveFields, sec)

  let md = stripHtmlCommentsOutsideFences(stripYamlFrontmatter(tpl.raw))
  let matchedCount = 0
  const applyReplace = (candidates, val) => {
    const r = replaceSectionIfPresent(md, candidates, val)
    md = r.text
    if (r.matched) matchedCount += 1
    return r.matched
  }
  const replaceOrRemove = (candidates, val) => {
    if (val) applyReplace(candidates, val)
    else md = removeSectionIfPresent(md, candidates).text
  }

  replaceOrRemove(['期望发生什么', '期望的用法与结果', '期望与方案', '预期行为', 'Expected Behavior', 'Expected Result', 'Expected'], sec.expected)
  replaceOrRemove([
    '实际发生什么', '想解决什么问题', '背景与现象', '问题概述', '问题描述', '现象',
    'Actual Behavior', 'Describe the bug', 'What happened', 'What happened?', 'Problem', 'Context', 'Summary', 'Description', 'Is your feature request related to a problem?',
  ], sec.actual)
  const reproCandidates = ['怎么复现', '复现步骤', 'Steps to Reproduce', 'To Reproduce', 'Reproduction']
  if (sec.repro) applyReplace(reproCandidates, sec.repro)
  else md = removeSectionIfPresent(md, reproCandidates).text
  replaceOrRemove(['环境', '版本与环境', 'Environment', 'Desktop', 'System Info'], sec.environment)
  replaceOrRemove(['影响面与严重度', '影响范围', '范围与依据', 'Scope', 'Impact'], sec.impact)
  replaceOrRemove(['备选方案，以及不这样做的后果', '备选方案', 'Alternatives', 'Describe alternatives you\'ve considered'], sec.alternatives)
  replaceOrRemove(['补充信息', 'Additional Context', 'Additional context', '根因与影响'], sec.extra)
  replaceOrRemove(['验收标准', 'Acceptance Criteria'], sec.criteria)
  replaceOrRemove(['不在本次范围', 'Out of Scope'], sec.outOfScope)
  replaceOrRemove(['关联的设计产物', 'Related Docs', 'Related Issues'], sec.docRefs)

  if (matchedCount === 0) {
    const fallback = buildFallbackIssueBody(effectiveFields, sec).trimEnd()
    const customTrimmed = md.trim()
    const parts = [fallback]
    if (customTrimmed && !fallback.includes(customTrimmed)) {
      parts.push(customTrimmed)
    }
    if (rawExplicit && !parts.some((p) => p.includes(rawExplicit))) {
      parts.push(rawExplicit)
    }
    md = parts.join('\n\n')
  } else if (rawExplicit && !md.includes(rawExplicit)) {
    const stripped = md.trimEnd()
    md = stripped ? `${stripped}\n\n${rawExplicit}` : rawExplicit
  }

  if (effectiveFields.nextStep && !/\[NEXT STEP\]/.test(md)) {
    md = `${md.trimEnd()}\n\n## [NEXT STEP]\n\n[NEXT STEP] ${String(effectiveFields.nextStep).trim()}`
  }
  const rendered = `${md.replace(/\n{3,}/g, '\n\n').trim()}\n`
  assertNoAsciiControlChars(rendered, 'Issue 模板渲染正文')
  return rendered
}
