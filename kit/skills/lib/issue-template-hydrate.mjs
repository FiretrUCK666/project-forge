/**
 * issue-template-hydrate.mjs —— Issue 模板水合与本地/通用远端结构化降级（零模板占位与字面量 `\n` 泄漏）。
 *
 * 复用 `pr-template-hydrate.mjs` 的围栏外 HTML 注释剥离与节替换逻辑，尊重宿主仓库自定义
 * `.github/ISSUE_TEMPLATE/`，在无模板、local-only 或 generic-git 下优雅降级为干净结构化 Markdown。
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
  const raw = Array.isArray(fields?.criteria) ? fields.criteria.filter(Boolean) : []
  if (raw.length > 0) {
    return raw.map((c, idx) => {
      const t = String(c).trim()
      return /^- \[[ xX]\]\s+C\d+\b/.test(t) ? t : `- [ ] C${idx + 1}: ${t}`
    }).join('\n')
  }
  const label = String(fields?.title ?? fields?.summary ?? '当前任务').trim()
  return `- [ ] C1: 完成「${label}」并补齐正反双向验证与全量门禁`
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
    fields.summary || fields.context || fields.problem || fields.title || '待补充说明。',
  ).trim()
  const actualLines = [metaParts.length > 0 ? metaParts.join(' | ') : null, summary]
  if (fields.findingsSummary) actualLines.push('', normalizeEscapedNewlines(fields.findingsSummary).trim())

  const expected = normalizeEscapedNewlines(
    fields.expected || (fields.title ? `完成「${fields.title}」并满足全部验收标准。` : '行为与既有契约、测试门禁及工程不变量保持一致。'),
  ).trim()

  const reproParts = []
  if (fields.repro) reproParts.push(normalizeEscapedNewlines(fields.repro).trim())
  if (fields.reproEvidence) reproParts.push(`- 最小复现：${normalizeEscapedNewlines(fields.reproEvidence).trim()}`)
  if (fields.pocCommand) reproParts.push(`- 复现命令：\`${String(fields.pocCommand).trim()}\``)

  const scopeLines = []
  if (fields.scope) scopeLines.push(normalizeEscapedNewlines(fields.scope).trim())
  if (fields.taskId) scopeLines.push(`- 任务标识：\`${fields.taskId}\``)
  if (fields.docRefs) scopeLines.push(`- 关联文档：${fields.docRefs}`)
  if (Array.isArray(fields.files) && fields.files.length > 0) {
    scopeLines.push(`- 涉及路径：${fields.files.slice(0, 8).map((f) => `\`${posixPath(f)}\``).join('、')}`)
  } else if (typeof fields.files === 'string' && fields.files.trim()) {
    const fs = fields.files.split(/[\s,]+/).filter(Boolean).slice(0, 8).map((f) => `\`${posixPath(f)}\``).join('、')
    if (fs) scopeLines.push(`- 涉及路径：${fs}`)
  }

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
    actual: actualLines.filter((x) => x !== null).join('\n').trim(),
    expected,
    repro: reproParts.join('\n').trim(),
    scope: scopeLines.join('\n').trim(),
    extra: extraLines.join('\n').trim(),
    criteria: formatCriteriaLines(fields),
    environment: normalizeEscapedNewlines(fields.environment || '').trim() || '- 运行时与仓内环境见复现/验证记录。',
    alternatives: normalizeEscapedNewlines(fields.alternatives || fields.rootCause || '').trim() || '- 按根因收敛方案实施，避免临时绕过。',
    outOfScope: normalizeEscapedNewlines(fields.outOfScope || '').trim() || '- 未列入本单验收标准的无关改动。',
    docRefs: fields.docRefs || (fields.taskId ? `- 任务：\`${fields.taskId}\`` : '- 见仓内关联设计文档。'),
  }
}

function buildFallbackIssueBody(fields = {}, sec) {
  const lines = ['## 背景与现象', '', sec.actual]
  if (sec.scope) lines.push('', '## 范围与依据', '', sec.scope)
  if (sec.extra) lines.push('', '## 根因与影响', '', sec.extra)
  if (sec.repro) lines.push('', '## 复现线索', '', sec.repro)
  lines.push('', '## 验收标准', '', sec.criteria)
  if (fields.nextStep) lines.push('', '## [NEXT STEP]', '', `[NEXT STEP] ${String(fields.nextStep).trim()}`)
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`
}

/**
 * 水合工单正文：优先读取 `.github/ISSUE_TEMPLATE/` 模板（剥离 frontmatter 与围栏外 HTML 注释），
 * 保留自定义标题并填入实际上下文/复现/验收标准；无模板或显式结构化输入时安全降级。
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

  applyReplace(['期望发生什么', '期望的用法与结果', '预期行为', 'Expected Behavior', 'Expected Result', 'Expected'], sec.expected)
  applyReplace([
    '实际发生什么', '想解决什么问题', '背景与现象', '问题概述', '问题描述', '现象',
    'Actual Behavior', 'Describe the bug', 'What happened', 'What happened?', 'Problem', 'Context', 'Summary', 'Description', 'Is your feature request related to a problem?',
  ], sec.actual)
  const reproCandidates = ['怎么复现', '复现步骤', 'Steps to Reproduce', 'To Reproduce', 'Reproduction']
  if (sec.repro) applyReplace(reproCandidates, sec.repro)
  else md = removeSectionIfPresent(md, reproCandidates).text
  applyReplace(['环境', '版本与环境', 'Environment', 'Desktop', 'System Info'], sec.environment)
  const scopeCandidates = ['影响范围', '范围与依据', 'Scope', 'Impact']
  if (sec.scope) applyReplace(scopeCandidates, sec.scope)
  else md = removeSectionIfPresent(md, scopeCandidates).text
  applyReplace(['备选方案，以及不这样做的后果', '备选方案', 'Alternatives', 'Describe alternatives you\'ve considered'], sec.alternatives)
  const extraCandidates = ['补充信息', 'Additional Context', 'Additional context', '根因与影响']
  if (sec.extra) applyReplace(extraCandidates, sec.extra)
  else md = removeSectionIfPresent(md, extraCandidates).text
  applyReplace(['验收标准', 'Acceptance Criteria'], sec.criteria)
  applyReplace(['不在本次范围', 'Out of Scope'], sec.outOfScope)
  applyReplace(['关联的设计产物', 'Related Docs', 'Related Issues'], sec.docRefs)

  if (rawExplicit && (matchedCount === 0 || !md.includes(rawExplicit))) {
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
