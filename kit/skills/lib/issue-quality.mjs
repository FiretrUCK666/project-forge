/**
 * issue-quality.mjs —— 单一平台中性 Issue 质量契约与自动查盘判定引擎。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块与同层 L1/L2 原语），严禁字数/字节死线与双模式开关；
 * 供 `escalation.mjs`、`flow-issues.mjs` 与 `govern-audit.mjs` 统一在 `TaskBackend.createIssue` 前拦截低质量建单。
 */

import { existsSync } from 'node:fs'
import { basename, join } from 'node:path'

import { parseDocFrontmatter } from './doc-frontmatter.mjs'
import { PLACEHOLDER_TEXT_RE, VAGUE_FLUFF_RE, extractTechAnchors, isStubValue } from './doc-substantive.mjs'
import { EXIT } from './exit-codes.mjs'
import { posixPath, readTextSafe } from './git.mjs'
import { scanLines, stripMarkdownCodeSpans } from './markdown-scan.mjs'
import { indexPlanDocs, resolvePlanDocRoots } from './plan-index.mjs'

export const ISSUE_QUALITY_RULES = Object.freeze({
  version: 1,
  singleChannel: 'hydrateIssueBody -> validateIssueBodyQuality -> TaskBackend.createIssue',
  exitCode: EXIT.FACT,
  code: 'BLOCKED_ISSUE_QUALITY_INCOMPLETE',
  baselineItems: Object.freeze([
    'context',
    'impact',
    'evidence',
    'criteria',
    'outOfScope',
  ]),
})

const PLAN_DOC_PATH_RE = /(?:^|[\s`'"(\[（:：,、])((?:\.\/)?docs\/(?:archive\/)?(?:prd|specs|todo)\/[^\s`'")\]>]+?\.md)(?=$|[\s`'")\]>,，。；;、])/gi
const FILE_LINE_RE = /(?:^|[\s`'"(\[（:：,、])((?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.[A-Za-z0-9]{1,8}:\d+(?::\d+)?)(?=$|[\s`'")\]>,，。；;、])/g
const REPO_FILE_PATH_RE = /(?:^|[\s`'"(\[（:：,、])((?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\.[A-Za-z0-9]{1,8})(?=$|[\s`'")\]>,，。；;、])/g
const EXIT_OR_ERROR_RE = /(?:exit(?:\s+code)?\s*[:：=]\s*\d+|退出码\s*[:：=]?\s*\d+|\b(?:TypeError|SyntaxError|ReferenceError|RangeError|AssertionError|Error)\s*:|\bfail(?:ed|ure)?\b|stderr=|stdout=)/i
const SEVERITY_OR_RISK_BOUNDARY_RE = /(?:severity\s*[:：=]|严重度|严重级别|影响程度|\b(?:critical|high|medium|low)\b|高危|中危|低危|高风险|中风险|低风险|数据模型|数据持久化|持久化|API|接口|协议|契约|权限|认证|鉴权|安全|兼容|破坏性|迁移|不涉及|无破坏|仅局部|单一模块|\b(?:data|schema|storage|auth|permission|security|compatibility|breaking)\b)/i
const EXPECTED_KW_RE = /(?:期望|预期|方案|根因|修复方向|建议|备选|选项|待裁决|expected|proposal|alternatives|solution|action|next\s*step|should\b)/i
const CONCRETE_EXCLUSION_RE = /(?:不动|不改|不修改|不引入|不新增|不做|不碰|不依赖|排除|不涉及|不含|不包括|仅限|范围外|非目标|out\s+of\s+scope|won'?t\s+(?:do|touch|change|modify|support)|exclude|not\s+in\s+scope|no\s+(?:GUI|API|network|external|third-party|change))/i

const CONTEXT_HEADINGS = [
  '背景与现象', '背景与边界', '想解决什么问题', '实际发生什么', '问题描述', '问题概述',
  '背景', '现状', '已知局限', '已核实基线与局限', 'Evidence', 'Unknowns', 'Problem',
  'Context', 'Summary', 'Background', 'Describe the bug', 'What happened', 'What happened?',
  'Description', 'Is your feature request related to a problem?',
]
const IMPACT_HEADINGS = [
  '影响面与严重度', '影响范围', '范围与依据', '影响面', '根因与影响',
  'Scope', 'Impact', 'Affected Scope',
]
const EXPECTED_HEADINGS = [
  '期望发生什么', '期望的用法与结果', '期望与方案', '预期行为', '备选方案，以及不这样做的后果',
  '备选方案', '方案', '根因与影响', 'Expected Behavior', 'Expected Result', 'Expected',
  'Proposal', 'Alternatives', 'Describe alternatives you\'ve considered', 'NextSteps', 'Action',
]
const CRITERIA_HEADINGS = ['验收标准', 'Acceptance Criteria', '验收']
const OUT_OF_SCOPE_HEADINGS = ['不在本次范围', 'Out of Scope', '非目标', '本期不做', '范围外', 'Non-Goals']

function stripCommentsOutsideFences(md) {
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
  return out.join('\n')
}

function parseIssueSections(md) {
  const lines = scanLines(md)
  const sections = []
  let cur = null
  for (const info of lines) {
    if (!info.inFence) {
      const h = /^(#{2,3})\s+(.+?)\s*$/.exec(info.line)
      const b = !h ? /^\*\*([^*]+?)\*\*\s*(?:[:：]\s*)?$/.exec(info.line.trim()) : null
      if (h || b) {
        if (cur) sections.push(cur)
        const rawTitle = (h ? h[2] : b[1]).trim()
        const normTitle = rawTitle
          .replace(/^(?:\d+[.)、]\s*|[一二三四五六七八九十]+[、.)]\s*)/, '')
          .replace(/[:：]\s*$/, '')
          .trim()
        cur = { title: rawTitle, normTitle, lines: [] }
        continue
      }
    }
    if (cur) cur.lines.push(info.raw)
  }
  if (cur) sections.push(cur)
  return sections.map((s) => ({ ...s, text: s.lines.join('\n').trim() }))
}

function findMatchingSections(sections, candidates) {
  const lowCands = candidates.map((c) => c.toLowerCase())
  return sections.filter((s) => {
    const low = s.normTitle.toLowerCase()
    return lowCands.some((c) => low === c || low.includes(c))
  })
}

function stripMetaLine(text) {
  return String(text ?? '')
    .split('\n')
    .filter((l) => !/^(?:Case\s+\d+\b|source=|tier=|task=|category=|severity=)/i.test(l.trim()))
    .join('\n')
    .trim()
}

function hasUnfilledPlaceholders(text) {
  const stripped = stripMarkdownCodeSpans(String(text ?? ''))
  if (/^\s*\d+[.、)]\s*$/m.test(stripped)) return true
  if (/^\s*-\s*\[[ xX]\]\s*(?:C\d+\s*[:：]?)?\s*$/m.test(stripped)) return true
  if (/^\s*-\s*(?:操作系统与版本|相关运行时\s*\/\s*工具的版本|项目版本或提交标识)\s*[:：]\s*$/m.test(stripped)) return true
  return false
}

function isSubstantiveBlock(text) {
  const clean = stripMetaLine(text)
  if (!clean) return false
  if (hasUnfilledPlaceholders(clean)) return false
  const nonEmptyLines = clean.split('\n').map((l) => l.trim()).filter(Boolean)
  if (nonEmptyLines.length === 0 || nonEmptyLines.every((l) => isStubValue(l))) return false
  if (PLACEHOLDER_TEXT_RE.test(clean) && extractTechAnchors(clean).count === 0) return false
  if (VAGUE_FLUFF_RE.test(clean) && extractTechAnchors(clean).count === 0) return false
  return true
}

/** 从非代码围栏正文抽取所有引用的 `docs/{prd,specs,todo}/...md` 路径。 */
export function extractPlanDocRefsFromText(text) {
  const cleaned = stripCommentsOutsideFences(String(text ?? ''))
  const lines = scanLines(cleaned)
  const seen = new Set()
  const out = []
  for (const info of lines) {
    if (info.inFence) continue
    PLAN_DOC_PATH_RE.lastIndex = 0
    for (const m of info.line.matchAll(PLAN_DOC_PATH_RE)) {
      const norm = posixPath(m[1]).replace(/^\.\//, '').replace(/[.,;，；:：]+$/, '')
      if (norm && !seen.has(norm)) {
        seen.add(norm)
        out.push(norm)
      }
    }
  }
  return out
}

function resolveDocOnDisk(repoRoot, mainRoot, rawRef) {
  const norm = posixPath(String(rawRef ?? '')).replace(/^\.\//, '').trim()
  if (!norm) return null
  const roots = resolvePlanDocRoots({ repoRoot, mainRoot, includeWorktrees: true })
  const candidates = [norm]
  const activeM = /^docs\/(prd|specs|todo)\/(.+)$/.exec(norm)
  if (activeM) candidates.push(`docs/archive/${activeM[1]}/${activeM[2]}`)
  for (const r of roots) {
    for (const rel of candidates) {
      const abs = join(r.dir, rel)
      if (existsSync(abs)) {
        return { requested: norm, resolvedRel: rel, abs, rootDir: r.dir, source: r.source }
      }
    }
  }
  return null
}

function collectPlanDocPresence(repoRoot, mainRoot, explicitRefs, bodyText) {
  const explicit = explicitRefs.map((r) => posixPath(String(r ?? '')).replace(/^\.\//, '').trim()).filter(Boolean)
  const textRefs = extractPlanDocRefsFromText(bodyText)
  const allRefs = [...new Set([...explicit, ...textRefs])]
  const verifiedDocRefs = []
  const invalidDocRefs = []
  if (allRefs.length === 0) return { verifiedDocRefs, invalidDocRefs }

  if (!repoRoot && !mainRoot) {
    return { verifiedDocRefs: [], invalidDocRefs: explicit }
  }
  const indexed = indexPlanDocs({ repoRoot: repoRoot || mainRoot, mainRoot: mainRoot || repoRoot, includeArchive: true, includeWorktrees: true })
  const indexedSet = new Set(indexed.map((d) => d.rel))
  for (const ref of allRefs) {
    if (indexedSet.has(ref)) {
      verifiedDocRefs.push(ref)
      continue
    }
    const found = resolveDocOnDisk(repoRoot, mainRoot, ref)
    if (found) verifiedDocRefs.push(ref)
    else invalidDocRefs.push(ref)
  }
  return { verifiedDocRefs, invalidDocRefs }
}

/** 从真实在盘规划文档提取摘要、影响文件、Out of Scope 与验收标准，供水合复用（免手写重复抄写）。 */
export function extractPlanDocContext(repoRoot, docPaths = [], opts = {}) {
  const mainRoot = opts.mainRoot ?? repoRoot
  const list = (Array.isArray(docPaths) ? docPaths : [docPaths])
    .map((p) => posixPath(String(p ?? '')).replace(/^\.\//, '').trim())
    .filter(Boolean)
  const verifiedDocRefs = []
  const invalidDocRefs = []
  const filesSet = new Set()
  const criteria = []
  const seenCriteriaIds = new Set()
  const outOfScopeLines = []
  const seenOutOfScope = new Set()
  let title = ''
  let summary = ''

  for (const ref of list) {
    const resolved = resolveDocOnDisk(repoRoot, mainRoot, ref)
    if (!resolved) {
      invalidDocRefs.push(ref)
      continue
    }
    verifiedDocRefs.push(ref)
    const raw = readTextSafe(resolved.abs) ?? ''
    const fm = parseDocFrontmatter(raw)
    if (!title && typeof fm.data?.title === 'string' && fm.data.title.trim()) {
      title = fm.data.title.trim()
    }
    if (Array.isArray(fm.data?.scope_files)) {
      for (const f of fm.data.scope_files) {
        const clean = posixPath(String(f ?? '')).replace(/^\.\//, '').trim()
        if (clean && !/[*]/.test(clean)) filesSet.add(clean)
      }
    }
    const body = stripCommentsOutsideFences(fm.body || raw)
    const sections = parseIssueSections(body)
    if (!summary) {
      const sentenceMatch = /^-\s+\*\*变更一句话\*\*\s*[:：]\s*(.+)$/m.exec(body)
        ?? /^-\s+\*\*要改什么\*\*\s*[:：]\s*(.+)$/m.exec(body)
        ?? /^-\s+\*\*目标\*\*\s*[:：]\s*(.+)$/m.exec(body)
      if (sentenceMatch) summary = sentenceMatch[1].trim()
      else {
        const bgSec = findMatchingSections(sections, ['背景与边界声明', '要做什么', '要解决的问题', '背景', '任务范围与验证基准'])[0]
        if (bgSec) {
          const firstLine = bgSec.text.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('|') && !l.startsWith('#'))
          if (firstLine) summary = firstLine.replace(/^[-*]\s+/, '').trim()
        }
      }
    }

    // 仅从第一个产出实质非目标的规划文档（SPEC 优先）采纳 Out of Scope，避免 SPEC 与 Todo 重复拼接
    if (outOfScopeLines.length === 0) {
      const pushOutOfScope = (lineText) => {
        const clean = String(lineText ?? '').trim()
        const norm = clean.replace(/^[-*]\s*/, '').replace(/\s+/g, ' ').toLowerCase()
        if (!clean || !norm || seenOutOfScope.has(norm)) return
        seenOutOfScope.add(norm)
        outOfScopeLines.push(clean)
      }
      const nonGoalInline = /^-\s+\*\*(?:本期不做|不改什么|不在本次范围|非目标)\*\*\s*[:：]\s*(.+)$/gm
      for (const m of body.matchAll(nonGoalInline)) {
        const v = m[1].trim()
        if (v && !isStubValue(v)) pushOutOfScope(`- ${v}`)
      }
      const nonGoalSec = findMatchingSections(sections, ['不在本次范围', '本期不做', '非目标', 'Out of Scope'])[0]
      if (nonGoalSec && outOfScopeLines.length === 0) {
        for (const ln of nonGoalSec.text.split('\n').map((l) => l.trim()).filter(Boolean)) {
          if (!ln.startsWith('|') && !ln.startsWith('#') && !isStubValue(ln)) pushOutOfScope(ln)
        }
      }
    }

    for (const info of scanLines(body)) {
      if (info.inFence) continue
      const cm = /^\s*-\s+\[[ xX]\]\s+C(\d+)\s*[:：]\s*(.+)$/.exec(info.line)
      if (cm) {
        const cid = `C${Number(cm[1])}`
        if (!seenCriteriaIds.has(cid)) {
          seenCriteriaIds.add(cid)
          criteria.push(`- [ ] ${cid}: ${cm[2].trim()}`)
        }
      }
      if (filesSet.size < 8) {
        const pathLine = /^-\s+\*\*(?:影响路径|涉及路径)\*\*\s*[:：]\s*(.+)$/.exec(info.line.trim())
        if (pathLine) {
          for (const pm of pathLine[1].matchAll(/`([^`\n]+\.[A-Za-z0-9]{1,8})`/g)) {
            filesSet.add(posixPath(pm[1]).trim())
          }
        }
      }
    }
  }

  return {
    verifiedDocRefs,
    invalidDocRefs,
    title,
    summary,
    files: [...filesSet],
    outOfScope: outOfScopeLines.slice(0, 6).join('\n'),
    criteria: criteria.slice(0, 8),
    docRefsText: verifiedDocRefs.map((p) => `- \`${p}\``).join('\n'),
  }
}

function checkContextItem(sections, cleanBody) {
  const matched = findMatchingSections(sections, CONTEXT_HEADINGS)
  if (matched.length > 0) {
    return matched.some((s) => isSubstantiveBlock(s.text))
  }
  return isSubstantiveBlock(cleanBody)
}

function checkImpactItem(sections, cleanBody) {
  const matched = findMatchingSections(sections, IMPACT_HEADINGS)
  const checkText = (txt) => {
    if (!isSubstantiveBlock(txt)) return false
    const anchors = extractTechAnchors(txt)
    const hasScopeAnchor = anchors.count > 0 || /(?:模块|目录|文件|脚本|接口|全仓|单文件|跨模块|module|file|dir|component)/i.test(txt)
    const hasRiskOrSev = SEVERITY_OR_RISK_BOUNDARY_RE.test(txt)
    return hasScopeAnchor && hasRiskOrSev
  }
  if (matched.length > 0 && matched.some((s) => checkText(s.text))) return true
  // 兼容结构化字段直接出现在正文中（如 Evidence/Unknowns + 影响面与严重度元数据）
  const anchors = extractTechAnchors(cleanBody)
  const hasSeverity = /(?:severity\s*[:：=]|严重度|严重级别|\b(?:critical|high|medium|low)\b)/i.test(cleanBody)
  const hasImpactScope = /(?:影响|波及|范围|模块|涉及路径|files|module|impact|scope)/i.test(cleanBody) && anchors.count > 0
  return hasSeverity && hasImpactScope
}

function checkSelfContainedEvidence(sections, cleanBody, repoRoot) {
  const lines = scanLines(cleanBody)
  let hasFenceCmdOrTrace = false
  let hasFileLine = false
  let hasRepoPath = false
  let hasCodeCmd = false
  let hasExitOrErr = false

  for (const info of lines) {
    if (info.inFence) {
      if (info.line.trim() && !/^\s*(?:```|~~~)/.test(info.line)) hasFenceCmdOrTrace = true
      continue
    }
    if (FILE_LINE_RE.test(info.line)) hasFileLine = true
    FILE_LINE_RE.lastIndex = 0
    if (EXIT_OR_ERROR_RE.test(info.line)) hasExitOrErr = true
    for (const m of info.line.matchAll(REPO_FILE_PATH_RE)) {
      const candidate = posixPath(m[1]).replace(/^\.\//, '')
      if (!repoRoot || existsSync(join(repoRoot, candidate))) {
        hasRepoPath = true
        break
      }
    }
    REPO_FILE_PATH_RE.lastIndex = 0
    for (const cm of info.line.matchAll(/`([^`\n]+)`/g)) {
      const tok = cm[1].trim()
      if (!tok || PLACEHOLDER_TEXT_RE.test(tok)) continue
      if (/\s/.test(tok) || /\.(?:mjs|cjs|js|ts|py|go|rs|sh|json|md)\b/i.test(tok) || /^--[a-z]/i.test(tok)) {
        hasCodeCmd = true
      }
    }
  }

  const hasFactualEvidence = hasFileLine || hasRepoPath || hasCodeCmd || hasFenceCmdOrTrace || hasExitOrErr
  if (!hasFactualEvidence) return false

  const expSecs = findMatchingSections(sections, EXPECTED_HEADINGS)
  if (expSecs.some((s) => isSubstantiveBlock(s.text))) return true
  return EXPECTED_KW_RE.test(cleanBody) && !VAGUE_FLUFF_RE.test(cleanBody.replace(/`[^`\n]+`/g, ''))
}

function checkCriteriaItem(sections, cleanBody) {
  const matched = findMatchingSections(sections, CRITERIA_HEADINGS)
  const checkLines = (txt) => {
    const out = []
    for (const info of scanLines(txt)) {
      if (info.inFence) continue
      const cm = /^\s*-\s*\[[ xX]\]\s*(.*)$/.exec(info.line)
      if (cm) out.push({ raw: info.line.trim(), text: cm[1].trim(), isCheck: true })
      else if (/^\s*(?:[-*]|\d+\.)\s+(.+)$/.test(info.line)) {
        out.push({ raw: info.line.trim(), text: info.line.replace(/^\s*(?:[-*]|\d+\.)\s+/, '').trim(), isCheck: false })
      }
    }
    return out
  }

  const candidates = matched.length > 0
    ? matched.flatMap((s) => checkLines(s.text))
    : checkLines(cleanBody).filter((c) => c.isCheck && /^C\d+\b/i.test(c.text))

  const valid = candidates.filter((item) => {
    const bodyText = item.text.replace(/^C\d+\s*[:：]?\s*/i, '').trim()
    if (!bodyText || isStubValue(bodyText) || PLACEHOLDER_TEXT_RE.test(bodyText)) return false
    const anchors = extractTechAnchors(bodyText)
    if (VAGUE_FLUFF_RE.test(bodyText) && anchors.count === 0) return false
    const hasCriterionId = /^C\d+\b/i.test(item.text)
    return (hasCriterionId && bodyText.length >= 4) || anchors.count > 0
  })

  return valid.length > 0
}

function checkOutOfScopeItem(sections, cleanBody) {
  const matched = findMatchingSections(sections, OUT_OF_SCOPE_HEADINGS)
  const checkScopeText = (txt) => {
    if (!isSubstantiveBlock(txt)) return false
    const anchors = extractTechAnchors(txt)
    if (anchors.hasConcreteExclusion || anchors.count > 0) return true
    return CONCRETE_EXCLUSION_RE.test(txt) && !VAGUE_FLUFF_RE.test(txt)
  }
  if (matched.length > 0 && matched.some((s) => checkScopeText(s.text))) return true
  for (const info of scanLines(cleanBody)) {
    if (info.inFence) continue
    if (/^(?:[-*]\s*)?(?:\*\*)?(?:不在本次范围|Out\s+of\s+Scope|本期不做|非目标)(?:\*\*)?\s*[:：]\s*(.+)$/i.test(info.line.trim())) {
      const val = info.line.trim().replace(/^.*?[:：]\s*/, '')
      if (checkScopeText(val)) return true
    }
  }
  return false
}

/**
 * 唯一共享 Issue 质量校验入口：5 项结构底线 + 自动查盘判定（无字数门槛、无双模式开关）。
 */
export function validateIssueBodyQuality(body, opts = {}) {
  const repoRoot = opts.repoRoot ?? null
  const mainRoot = opts.mainRoot ?? repoRoot
  const raw = String(body ?? '').replace(/\r\n/g, '\n')
  const cleanBody = stripCommentsOutsideFences(raw).trim()

  const explicitRefs = [
    opts.spec,
    opts.todo,
    opts.prd,
    ...(Array.isArray(opts.docRefs) ? opts.docRefs : (opts.docRefs ? [opts.docRefs] : [])),
  ].filter(Boolean)

  const { verifiedDocRefs, invalidDocRefs } = collectPlanDocPresence(repoRoot, mainRoot, explicitRefs, cleanBody)
  const hasRealLinkedPlanDoc = verifiedDocRefs.length > 0 && invalidDocRefs.length === 0
  const sections = parseIssueSections(cleanBody)

  const missing = []
  const reasons = []

  if (!cleanBody || hasUnfilledPlaceholders(cleanBody)) {
    if (!cleanBody) {
      missing.push('context', 'impact', 'evidence', 'criteria', 'outOfScope')
      reasons.push('Issue 正文为空，缺少全部 5 项结构底线')
    } else {
      reasons.push('Issue 正文仍含未填占位行（如空列表 1./2./3. 或空白复选框）')
    }
  }

  const contextOk = Boolean(cleanBody) && !hasUnfilledPlaceholders(cleanBody) && checkContextItem(sections, cleanBody)
  if (!contextOk && !missing.includes('context')) {
    missing.push('context')
    reasons.push('缺少实质性「背景/现象与基线（或已知局限）」（不可为空壳、占位或无锚点套话）')
  }

  const impactOk = Boolean(cleanBody) && checkImpactItem(sections, cleanBody)
  if (!impactOk && !missing.includes('impact')) {
    missing.push('impact')
    reasons.push('缺少「影响面与严重度」（须说明受影响模块/范围及严重度或数据/API/权限/安全/兼容性触及判定）')
  }

  let evidenceOk = false
  if (invalidDocRefs.length > 0) {
    missing.push('evidence')
    reasons.push(`存在仓内不存在的设计文档引用：${invalidDocRefs.join(', ')}`)
  } else if (hasRealLinkedPlanDoc) {
    evidenceOk = true
  } else if (cleanBody && checkSelfContainedEvidence(sections, cleanBody, repoRoot)) {
    evidenceOk = true
  } else if (!missing.includes('evidence')) {
    missing.push('evidence')
    reasons.push('无在盘设计文档时，正文须同时自包含真实源码/命令/复现证据与期望方案或待裁决选项')
  }

  const criteriaOk = Boolean(cleanBody) && !hasUnfilledPlaceholders(cleanBody) && checkCriteriaItem(sections, cleanBody)
  if (!criteriaOk && !missing.includes('criteria')) {
    missing.push('criteria')
    reasons.push('缺少可判伪「验收标准」（至少 1 条带具体锚点或命令断言的 `- [ ] C1: ...`）')
  }

  const outOfScopeOk = Boolean(cleanBody) && checkOutOfScopeItem(sections, cleanBody)
  if (!outOfScopeOk && !missing.includes('outOfScope')) {
    missing.push('outOfScope')
    reasons.push('缺少明确排除对象的「不在本次范围 / Out of Scope」声明')
  }

  const ok = missing.length === 0 && invalidDocRefs.length === 0
  return {
    ok,
    code: ok ? null : ISSUE_QUALITY_RULES.code,
    exitCode: ok ? EXIT.OK : EXIT.FACT,
    missing,
    reasons,
    hasRealLinkedPlanDoc,
    verifiedDocRefs,
    invalidDocRefs,
    checks: {
      context: contextOk,
      impact: impactOk,
      evidence: evidenceOk,
      criteria: criteriaOk,
      outOfScope: outOfScopeOk,
      noUnfilledPlaceholders: !hasUnfilledPlaceholders(cleanBody),
    },
  }
}
