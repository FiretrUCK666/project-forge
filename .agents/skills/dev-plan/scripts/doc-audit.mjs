/**
 * doc-audit.mjs —— 五档需求分流、规划文档静态自净化审计与 Critique 元信息剥离。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块），供 doc-plan.mjs 与外部测试引用。
 */

import { existsSync, readdirSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'

import { posixPath, readTextSafe } from '../../lib/git.mjs'
import { checkMermaidLabelWidth, evaluateCoupledSync, parseCoupledSyncRules, parseDocFilename, parseDocFrontmatter } from '../../lib/docs.mjs'
import { parseAgentsProfile, resolveAuthoritativeTddPath } from '../../lib/profile.mjs'
import { classifyDoorType } from '../../lib/static-gates.mjs'

export const VALID_STATUS_BY_TYPE = Object.freeze({
  prd: new Set(['draft', 'active', 'in_review', 'done', 'dropped']),
  spec: new Set(['draft', 'approved', 'implementing', 'in_review', 'implemented', 'superseded']),
  todo: new Set(['draft', 'active', 'pending', 'in_review', 'done', 'archived', 'dropped']),
})

const VAGUE_FLUFF_RE = /(?:提高质量|保证稳定|确保稳定|确保安全|优化体验|提升体验|完善功能|做好测试|提升性能|增强健壮性|代码整洁|按需处理|合理设计|正常工作|正常运行)/
const CONCRETE_ANCHOR_RE = /(?:`[^`]+`|\bexit\b|退出码|\bassert|expect|返回\s*\d|status\s*=|\.[a-z]{1,4}\b|\d+\s*(?:ms|s|条|项|个|KB|B|行))/i
const PLACEHOLDER_TEXT_RE = /(?:待补充|待填写|待核实|\bTBD\b|\bFIXME\b|<!--\s*(?:project-forge:\s*)?fill)/i
const ANGLE_PLACEHOLDER_RE = /<([^>\n]{1,60})>/g
const PATH_PREFIX_RE = /^(?:src|lib|kit|scripts|tests?|spec|app|apps|packages|pkg|cmd|internal|docs|templates|references|\.github)\//
const CONVENTION_DOC_DIRS = new Set(['docs/prd', 'docs/specs', 'docs/todo', 'docs/archive', 'docs/archive/prd', 'docs/archive/specs', 'docs/archive/todo'])

function scanActiveContracts(root) {
  const contracts = { tdd: Boolean(resolveAuthoritativeTddPath(root)), activeSpecs: [] }
  const specsDir = join(root, 'docs', 'specs')
  if (!existsSync(specsDir)) return contracts
  try {
    for (const name of readdirSync(specsDir).filter((n) => n.endsWith('.md')).sort()) {
      const text = readTextSafe(join(specsDir, name)) ?? ''
      const fm = parseDocFrontmatter(text)
      const status = String(fm.data?.status ?? 'unknown').toLowerCase()
      if (status === 'approved' || status === 'implementing' || status === 'implemented') {
        contracts.activeSpecs.push({ file: `docs/specs/${name}`, status })
      }
    }
  } catch { /* ignore */ }
  return contracts
}

function computeCoupledSyncWarnings(repoRoot, paths) {
  if (!repoRoot || !Array.isArray(paths) || paths.length === 0) return []
  const agentsText = readTextSafe(join(repoRoot, 'AGENTS.md'))
  if (!agentsText) return []
  const rules = parseCoupledSyncRules(agentsText)
  return rules.length > 0 ? evaluateCoupledSync(paths, rules, repoRoot) : []
}

/** 严格五档分流判定逻辑，同步输出 doorType、critiqueTier 与改哪看哪联动提醒。 */
export function triageTask({
  summary = '',
  files,
  touchesContract = false,
  conflictsTdd = false,
  docOnly = false,
  bugfix = false,
  paths = [],
  repoRoot,
} = {}) {
  const text = String(summary ?? '').trim()
  const fileCount = Number.isFinite(files) ? Number(files) : undefined
  const activeContracts = repoRoot ? scanActiveContracts(repoRoot) : { tdd: false, activeSpecs: [] }
  const profile = repoRoot ? parseAgentsProfile(repoRoot) : null
  const coupledSyncWarnings = computeCoupledSyncWarnings(repoRoot, paths)

  const conflictRe = /(?:conflicts?\s+(?:with\s+)?tdd|与\s*tdd\s*冲突|打破\s*tdd|推翻.*(?:架构|契约|spec)|违背.*(?:tdd|spec))/i
  const contractRe = /(?:跨模块|cross[- ]?module|external\s+contract|breaking\s+change|外部契约|接口变更|协议变更|schema\s*变更|架构重构|新增命令|新增子命令|api\s*契约|refactor\s+architecture)/i
  const runtimeBugRe = /\b(?:bug|bugfix|hotfix|crash|regression|exception|panic|broken|fail(?:ing|ure)?|error\s*\d*)\b|报错|异常|缺陷|故障|崩溃|复现|回归/i
  const fixVerbRe = /\bfix\b|修复|修一下|修正/i
  const docRe = /\b(?:typo|spelling|docs?(?:-only)?|readme|comment|explain|question|changelog)\b|文档|错别字|注释|问答|翻译|拼写|解释/i
  const explicitFeatureRe = /\b(?:feat|feature|implement|add\s+(?:support|command|flag|endpoint|api))\b|新功能|新增功能|开发新/i

  const isConflict = conflictsTdd || conflictRe.test(text)
  const isContract = touchesContract || (!docOnly && fileCount !== undefined && fileCount >= 6) || contractRe.test(text)
  const pureDocCue = docRe.test(text) && !runtimeBugRe.test(text) && !explicitFeatureRe.test(text) && !bugfix
  const looksDocOnly = docOnly || (pureDocCue && (fileCount === undefined || fileCount <= 3))
  const isBugfix = bugfix || (!looksDocOnly && (runtimeBugRe.test(text) || fixVerbRe.test(text)) && !explicitFeatureRe.test(text) && (fileCount === undefined || fileCount <= 3))

  const door = classifyDoorType({
    changedFiles: Array.isArray(paths) ? paths : [],
    summary: text,
    touchesContract: Boolean(isContract || isConflict),
    highRisk: profile?.highRisk ?? [],
    gateWeakened: /弱化门禁|跳过测试|skip\s+test/i.test(text),
  })

  if (isConflict) {
    return {
      caseType: 5, tier: 3, blocked: true, action: 'BLOCK_UPDATE_TDD_FIRST',
      doorType: 'one-way', doorDetails: { ...door, doorType: 'one-way' }, critiqueTier: 'independent-critique',
      reason: '该需求与 docs/TDD.md 或生效 SPEC 存在架构/契约冲突，必须先更新 TDD.md 并获人类确认后再拆解。',
      docsRequired: ['docs/TDD.md (先更新并确认)'], redGreenRequired: true, needsReview: true, specApprovalRequired: true,
      activeContracts, coupledSyncWarnings,
    }
  }
  if (isContract) {
    return {
      caseType: 4, tier: 2, blocked: false, action: 'SPEC_AND_TODO',
      doorType: door.doorType, doorDetails: door, critiqueTier: 'independent-critique',
      reason: '涉及跨模块协作或外部契约变更（L3），需先编写 SPEC 经内审 Critique 与批准后，再落地 Todo 与实现。',
      docsRequired: ['docs/specs/', 'docs/todo/'], optionalDocs: ['docs/prd/'],
      redGreenRequired: true, needsReview: true, specApprovalRequired: true, activeContracts, coupledSyncWarnings,
    }
  }
  if (looksDocOnly) {
    return {
      caseType: 1, tier: 1, blocked: false, action: 'NO_DOC_DIRECT',
      doorType: door.doorType, doorDetails: door, critiqueTier: 'none',
      reason: '属于文档完善或问答/错别字修正（Case 1），无需新增规划文档。',
      docsRequired: [], redGreenRequired: false, needsReview: door.doorType === 'one-way', specApprovalRequired: false,
      activeContracts, coupledSyncWarnings,
    }
  }
  if (isBugfix) {
    const bugNeedsReview = door.doorType === 'one-way' || door.signals.length > 0
    return {
      caseType: 2, tier: 1, blocked: false, action: 'NO_DOC_RED_GREEN',
      doorType: door.doorType, doorDetails: door, critiqueTier: 'none',
      reason: bugNeedsReview
        ? '属于触及高风险/单向门边界的缺陷修复（Case 2），须 Red-Green 回归并接受独立审查。'
        : '属于明确局部缺陷修复（Case 2），不建规划文档，但强制先补失败复现测试再修复（Red-Green）。',
      docsRequired: [], redGreenRequired: true, needsReview: bugNeedsReview, specApprovalRequired: false,
      activeContracts, coupledSyncWarnings,
    }
  }
  return {
    caseType: 3, tier: 2, blocked: false, action: 'TODO_ONLY',
    doorType: door.doorType, doorDetails: door, critiqueTier: 'self-audit',
    reason: '属于不改变外部契约的局部功能开发（L2），只需建立 docs/todo/ 冻结验收标准并通过 audit 自净化。',
    docsRequired: ['docs/todo/'], redGreenRequired: true, needsReview: true, specApprovalRequired: false,
    activeContracts, coupledSyncWarnings,
  }
}

/** 剥离易变生命周期元字段（保留方案正文、稳定标题/层级与验收标准），确保 link --issue/--pr 后不误触发陈旧锁定。 */
export function stripCritiqueMeta(text) {
  const norm = String(text ?? '').replace(/\r\n/g, '\n')
  const fm = parseDocFrontmatter(norm)
  const stableMeta = {
    kind: fm.data?.kind ?? null,
    title: fm.data?.title ?? null,
    tier: fm.data?.tier ?? null,
    high_risk_paths: Array.isArray(fm.data?.high_risk_paths) ? fm.data.high_risk_paths : [],
  }
  const volatileLineRe = /^(?:-\s+)?(?:Plan Critique|Status|Issue|PR|Updated|Branch|Owner|Related\s+(?:SPEC|PRD|Todo)|plan_critique|updated|issue|pr|status|related_prd|related_spec|related_todo|approved|implemented|done_at|branch|owner)\s*:/i
  const cleanBody = String(fm.body ?? norm)
    .split('\n')
    .filter((l) => !volatileLineRe.test(l.trim()))
    .join('\n')
    .replace(/(\bdocs\/(?:prd|specs|todo)\/\d{6})-issue\d+-/gi, '$1-')
    .trim()
  return `${JSON.stringify(stableMeta)}\n${cleanBody}`
}

export function detectDocType(relPath, text) {
  const fm = parseDocFrontmatter(text)
  const fn = parseDocFilename(relPath)
  const fmKind = fm.data?.kind
  if (fmKind === 'prd' || fmKind === 'spec' || fmKind === 'todo') return fmKind
  if (fn?.kind) return fn.kind
  const rel = posixPath(relPath).toLowerCase()
  if (rel.startsWith('docs/specs/') || rel.startsWith('docs/archive/specs/') || /^#\s*SPEC:/mi.test(text)) return 'spec'
  if (rel.startsWith('docs/prd/') || rel.startsWith('docs/archive/prd/') || /^#\s*PRD:/mi.test(text)) return 'prd'
  if (rel.startsWith('docs/todo/') || rel.startsWith('docs/archive/todo/') || /^#\s*Todo:/mi.test(text)) return 'todo'
  if (rel === 'docs/tdd.md' || /^#\s*.*TDD/mi.test(text)) return 'tdd'
  return 'generic'
}

function extractSections(text) {
  const sections = new Map()
  const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n')
  let curTitle = '_top'
  let curLines = []
  let inFence = false
  for (const line of lines) {
    if (/^\s*(?:```|~~~)/.test(line)) inFence = !inFence
    if (!inFence && /^##\s+(.+)$/.test(line)) {
      sections.set(curTitle, curLines.join('\n'))
      curTitle = line.replace(/^##\s+/, '').trim()
      curLines = []
    } else {
      curLines.push(line)
    }
  }
  sections.set(curTitle, curLines.join('\n'))
  return sections
}

function findSectionByKeywords(sections, keywords) {
  for (const [title, body] of sections.entries()) {
    if (keywords.some((kw) => title.toLowerCase().includes(kw.toLowerCase()))) return { title, body }
  }
  return null
}

function findFmKeyLine(lines, fmEndIdx, key) {
  if (fmEndIdx < 0) return 1
  const re = new RegExp(`^${key}\\s*:`)
  for (let idx = 1; idx < fmEndIdx; idx += 1) {
    if (re.test(lines[idx])) return idx + 1
  }
  return 1
}

function extractFrontmatterIssueInt(val) {
  if (val === undefined || val === null || val === '') return null
  if (typeof val === 'number') return Number.isInteger(val) && val > 0 ? val : NaN
  const s = String(val).trim()
  if (!s) return null
  if (/^#?\d+$/.test(s)) {
    const n = Number(s.replace(/^#/, ''))
    return n > 0 ? n : NaN
  }
  const urlMatch = /\/issues\/(\d+)(?:[/?#]|$)/.exec(s)
  return urlMatch ? Number(urlMatch[1]) : NaN
}

function isGenericOrJsxAngle(rawText, matchIdx, rawMatch, inner) {
  if (!inner || /@/.test(inner) || /^https?:\/\//i.test(inner)) return true
  if (matchIdx > 0 && /[A-Za-z0-9_:]/.test(rawText[matchIdx - 1])) return true
  if (rawMatch.endsWith('/>')) return true
  if (/^[A-Z][A-Za-z0-9_.]*(?:,\s*[A-Z][A-Za-z0-9_.?]*)*$/.test(inner)) return true
  if (/^(?:string|number|boolean|void|unknown|any|never|null|undefined|u8|u16|u32|u64|usize|i32|i64|f64|bool|char|str)(?:\s*[|,]\s*[A-Za-z0-9_.\s|]+)*$/.test(inner)) return true
  return false
}

function collectPlaceholderErrors(rawText, strippedText, lineNo, errors) {
  if (PLACEHOLDER_TEXT_RE.test(rawText)) {
    errors.push({
      code: 'UNRESOLVED_PLACEHOLDER',
      line: lineNo,
      message: `第 ${lineNo} 行包含未清理占位符文本`,
      fixHint: '请将「待补充/TBD/FIXME/fill」替换为真实结论、路径或可运行验证命令。',
    })
  }
  for (const am of strippedText.matchAll(ANGLE_PLACEHOLDER_RE)) {
    const inner = am[1].trim()
    if (isGenericOrJsxAngle(strippedText, am.index ?? 0, am[0], inner)) continue
    const looksPlaceholder = /[\u4e00-\u9fa5]|\||^(?:todo|tbd|path|file|cmd|slug|title|id|N|target|module|name|reason|owner|status|branch|spec|prd|placeholder|example|two-way\s*\|\s*one-way)$/i.test(inner)
      || /(?:^|[:：]\s*|-+\s+)<[^>]+>/.test(strippedText)
    if (looksPlaceholder) {
      errors.push({
        code: 'UNRESOLVED_ANGLE_PLACEHOLDER',
        line: lineNo,
        message: `第 ${lineNo} 行存在模板尖括号占位 <${inner}>`,
        fixHint: `请将 <${inner}> 替换为真实具体内容。`,
      })
    }
  }
}

function extractLinePathCandidates(strippedLine) {
  const cands = new Set()
  for (const bm of strippedLine.matchAll(/`([^`\n]+)`/g)) {
    const tok = bm[1].trim().replace(/\s*(?:\(\s*new\s*\)|（\s*new\s*）|\[\s*new\s*\]|新建|新增)\s*$/i, '').trim()
    if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.*{}/-]*$/.test(tok) && !tok.includes(' ')) {
      if (PATH_PREFIX_RE.test(tok) || /\.[a-z]{1,5}$/i.test(tok)) cands.add(tok)
    }
  }
  const withoutHttpRoutes = strippedLine.replace(/\b(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+\/?[A-Za-z0-9_./:-]+/gi, ' ')
  for (const pm of withoutHttpRoutes.matchAll(/(?:^|[\s(（:：,])((?:src|lib|kit|scripts|tests?|spec|apps?|packages|docs|templates|references)\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*\/?)/g)) {
    cands.add(pm[1].trim())
  }
  return [...cands]
}

function candHasNewAnnotation(strippedLine, rawCand) {
  const escCand = rawCand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const nearNewRe = new RegExp(
    `(?:新建|新增文件)\\s*[:：]?\\s*[\`"'“「]?[^\\s\`"'”」]*${escCand}(?![A-Za-z0-9_./-])`
    + `|(?<![A-Za-z0-9_./-])${escCand}[^\\n,;，；]{0,20}(?:\\(\\s*new\\s*\\)|（\\s*new\\s*）|\\[\\s*new\\s*\\]|新建|新增)`,
    'i',
  )
  return nearNewRe.test(strippedLine)
}

/** 规划文档静态自净化审计：两遍收集 `(new)`、校验 Mermaid 宽度、Frontmatter 与占位。 */
export function auditDoc({ repoRoot, file }) {
  const abs = resolve(repoRoot, file)
  if (!existsSync(abs)) throw new Error(`找不到待审查文档：${file}`)
  const rawText = readTextSafe(abs)
  if (rawText === undefined) throw new Error(`无法读取文本文件：${file}`)

  const relDoc = posixPath(relative(repoRoot, abs))
  const docType = detectDocType(relDoc, rawText)
  const errors = []
  const warnings = []
  const normRaw = rawText.replace(/\r\n/g, '\n')
  const lines = normRaw.split('\n')

  const fm = parseDocFrontmatter(normRaw)
  let fmEndIdx = -1
  if (normRaw.startsWith('---\n')) {
    for (let idx = 1; idx < lines.length; idx += 1) {
      if (lines[idx].trim() === '---') { fmEndIdx = idx; break }
    }
  }

  if (docType === 'spec' || docType === 'todo' || docType === 'prd') {
    if (fm.malformedFrontmatter) {
      for (const se of fm.syntaxErrors) {
        errors.push({ code: 'FRONTMATTER_INVALID', line: 1, message: se, fixHint: '请修复头部 YAML Frontmatter（`--- ... ---` 与 `key: value` 语法）。' })
      }
    } else if (fm.hasFrontmatter) {
      for (const [k, v] of Object.entries(fm.data)) {
        if (typeof v === 'string') collectPlaceholderErrors(v, v, findFmKeyLine(lines, fmEndIdx, k), errors)
      }
      if (!fm.data.kind) {
        errors.push({ code: 'FRONTMATTER_INVALID', line: 1, message: 'YAML Frontmatter 缺少 `kind` 字段（prd | spec | todo）', fixHint: `请在头部 Frontmatter 补充 \`kind: ${docType}\`。` })
      } else if (fm.data.kind !== docType) {
        errors.push({ code: 'FRONTMATTER_INVALID', line: findFmKeyLine(lines, fmEndIdx, 'kind'), message: `Frontmatter \`kind: ${fm.data.kind}\` 与文档目录类型 \`${docType}\` 不一致`, fixHint: `请确认文件路径与 \`kind: ${docType}\` 对齐。` })
      }

      const st = typeof fm.data.status === 'string' ? fm.data.status.toLowerCase() : ''
      if (!st) {
        errors.push({ code: 'FRONTMATTER_INVALID', line: 1, message: 'YAML Frontmatter 缺少 `status` 字段', fixHint: `请补充合法 status（${[...VALID_STATUS_BY_TYPE[docType]].join(' | ')}）。` })
      } else if (!VALID_STATUS_BY_TYPE[docType].has(st)) {
        errors.push({ code: 'INVALID_STATUS', line: findFmKeyLine(lines, fmEndIdx, 'status'), message: `Frontmatter \`status: ${fm.data.status}\` 不在 ${docType} 允许枚举中`, fixHint: `请改用：${[...VALID_STATUS_BY_TYPE[docType]].join(' | ')}。` })
      }

      const fmIssue = extractFrontmatterIssueInt(fm.data.issue)
      if (Number.isNaN(fmIssue)) {
        errors.push({ code: 'FRONTMATTER_INVALID', line: findFmKeyLine(lines, fmEndIdx, 'issue'), message: `Frontmatter \`issue\` 值格式无效：${fm.data.issue}`, fixHint: '请填写正整数 Issue 编号（如 `278`）或 `null`。' })
      } else {
        const fn = parseDocFilename(relDoc)
        if (fn && ((fmIssue && fn.issue !== fmIssue) || (fn.issue && fmIssue !== fn.issue))) {
          errors.push({ code: 'ISSUE_FILENAME_MISMATCH', line: findFmKeyLine(lines, fmEndIdx, 'issue'), message: `Frontmatter issue (${fmIssue ?? 'null'}) 与文件名 (${relDoc}) 的 -issue<N>- 不一致`, fixHint: '运行 `doc-plan.mjs link <file> --issue <N>` 对齐文件名与 Frontmatter。' })
        }
      }

      for (const rk of ['related_prd', 'related_spec', 'related_todo']) {
        const rv = fm.data[rk]
        if (typeof rv === 'string' && rv.trim() && !/^(?:无|none)$/i.test(rv.trim())) {
          if (!existsSync(resolve(dirname(abs), rv.trim()))) {
            errors.push({ code: 'BROKEN_RELATED_LINK', line: findFmKeyLine(lines, fmEndIdx, rk), path: rv.trim(), message: `Frontmatter \`${rk}: ${rv.trim()}\` 指向不存在的目标文件`, fixHint: '请核实相对路径或运行 `doc-plan.mjs link` 重新同步互链。' })
          }
        }
      }
    } else if (fm.data.status) {
      warnings.push({ code: 'LEGACY_HEADER_FORMAT', line: 1, message: '仍使用旧式列表头部元数据，建议通过 `doc-plan.mjs link` 升级为 YAML Frontmatter' })
      const st = String(fm.data.status).toLowerCase()
      if (!VALID_STATUS_BY_TYPE[docType].has(st)) {
        errors.push({ code: 'INVALID_STATUS', line: 1, message: `Status "${fm.data.status}" 不在 ${docType} 允许枚举中`, fixHint: `请改用：${[...VALID_STATUS_BY_TYPE[docType]].join(' | ')}。` })
      }
    } else {
      errors.push({ code: 'FRONTMATTER_INVALID', line: 1, message: '缺少 YAML Frontmatter（`--- ... ---`）及 status 元数据', fixHint: '请补齐标准 YAML Frontmatter（`kind`, `title`, `status`, `created`, `updated`）。' })
    }
  }

  const startBodyLine = fmEndIdx >= 0 ? fmEndIdx + 1 : 0
  const bodyLines = []
  let inFence = false
  let curSection = '_top'
  for (let i = startBodyLine; i < lines.length; i += 1) {
    const rawLine = lines[i]
    if (/^\s*(?:```|~~~)/.test(rawLine)) { inFence = !inFence; continue }
    if (inFence) continue
    if (/^##+\s+/.test(rawLine)) curSection = rawLine.replace(/^##+\s+/, '').trim()
    bodyLines.push({
      lineNo: i + 1,
      rawLine,
      strippedLine: rawLine.replace(/<!--[\s\S]*?-->/g, ''),
      skipPathCheck: /(?:完成后的记录|实现说明|本期不做|明确不做|非目标|Non-Goals)/i.test(curSection)
        || rawLine.includes('...')
        || /(?:已删除|删掉|不再使用|旧路径|不存在|\b(?:deleted|removed)\b)/i.test(rawLine),
    })
  }

  const declaredNewDirs = new Set()
  const declaredNewFiles = new Set()
  const docsFolderExists = existsSync(join(repoRoot, 'docs'))

  // Pass 1: 收集占位、套话与全部 (new) 声明
  for (const item of bodyLines) {
    collectPlaceholderErrors(item.rawLine, item.strippedLine, item.lineNo, errors)
    const isCriterion = /^- \[[ xX]\]\s+C\d+\b/.test(item.rawLine)
    if (isCriterion && VAGUE_FLUFF_RE.test(item.strippedLine) && !CONCRETE_ANCHOR_RE.test(item.strippedLine)) {
      errors.push({
        code: 'VAGUE_CRITERION',
        line: item.lineNo,
        message: `第 ${item.lineNo} 行验收标准空泛无具体可验证锚点：${item.rawLine.trim()}`,
        fixHint: '「说人话」规范要求每条 C* 给出真实可执行命令、断言条件、文件路径或精确错误码/退出码。',
      })
    }
    if (item.skipPathCheck) continue
    for (const rawCand of extractLinePathCandidates(item.strippedLine)) {
      if (/^(?:https?:|file:|mailto:|node:)/i.test(rawCand) || /[*?{}<>]/.test(rawCand)) continue
      const cleanRel = rawCand.replace(/^\.\//, '').replace(/\/+$/, '')
      if (!cleanRel || cleanRel === relDoc || !candHasNewAnnotation(item.strippedLine, rawCand)) continue
      const parentRel = posixPath(dirname(cleanRel))
      const parentExists = parentRel === '.' || existsSync(join(repoRoot, parentRel)) || declaredNewDirs.has(parentRel)
      if (parentExists) {
        if (rawCand.endsWith('/')) declaredNewDirs.add(cleanRel)
        declaredNewFiles.add(cleanRel)
      } else {
        errors.push({
          code: 'NEW_PATH_MISSING_PARENT',
          line: item.lineNo,
          path: cleanRel,
          message: `第 ${item.lineNo} 行标注新建路径 "${cleanRel}"，但其父目录 "${parentRel}" 不存在`,
          fixHint: `请核实父目录 ${parentRel} 真实存在（或先声明上级新建目录并补充真实基础路径）。`,
        })
      }
    }
  }

  // Pass 2: 校验全部引用路径（已存在或已在本篇标为 (new)）
  for (const item of bodyLines) {
    if (item.skipPathCheck) continue
    for (const rawCand of extractLinePathCandidates(item.strippedLine)) {
      if (/^(?:https?:|file:|mailto:|node:)/i.test(rawCand) || /[*?{}<>]/.test(rawCand)) continue
      if (rawCand.startsWith('docs/archive/') && /归档|archive/i.test(item.rawLine)) continue
      const cleanRel = rawCand.replace(/^\.\//, '').replace(/\/+$/, '')
      if (!cleanRel || cleanRel === relDoc) continue
      if (docsFolderExists && CONVENTION_DOC_DIRS.has(cleanRel)) continue
      if (candHasNewAnnotation(item.strippedLine, rawCand)) continue
      if (!existsSync(join(repoRoot, cleanRel)) && !declaredNewFiles.has(cleanRel) && !declaredNewDirs.has(cleanRel)) {
        errors.push({
          code: 'HALLUCINATED_PATH',
          line: item.lineNo,
          path: cleanRel,
          message: `第 ${item.lineNo} 行引用了仓库中不存在的路径 "${cleanRel}"（疑似未核实编造路径）`,
          fixHint: '先通过 dev-explore 核对真实文件名；若确实为本任务拟新建文件，请在其后标注 (new) 并保证父目录存在。',
        })
      }
    }
  }

  // Mermaid 防截断显示宽度检查（C4）
  const mermaidCheck = checkMermaidLabelWidth(normRaw)
  for (const mv of mermaidCheck.violations) {
    errors.push({
      code: mv.kind === 'html' ? 'MERMAID_HTML_FORBIDDEN' : 'MERMAID_LABEL_TOO_WIDE',
      line: mv.line,
      message: mv.message,
      fixHint: mv.fixHint,
    })
  }

  const bodyForSections = startBodyLine > 0 ? lines.slice(startBodyLine).join('\n') : normRaw
  const sections = extractSections(bodyForSections)
  if (docType === 'spec' || docType === 'todo' || docType === 'prd') {
    if (!/^- \[[ xX]\]\s+C1\b/m.test(normRaw)) {
      errors.push({ code: 'MISSING_ACCEPTANCE_CRITERIA', line: 1, message: '缺少至少一条「- [ ] C1: ...」可判定验收标准', fixHint: '动手前必须冻结 C1..Cn 标准，每条须能被一条命令或断言证明。' })
    }
    const nonGoalSec = findSectionByKeywords(sections, ['本期不做', '明确不做', '非目标', 'Non-Goals'])
    const hasNonGoalBullet = /-\s+\*\*本期不做\*\*\s*[:：]|###\s*(?:明确不做|Non-Goals)/i.test(bodyForSections)
    if ((!nonGoalSec || !nonGoalSec.body.replace(/<!--[\s\S]*?-->/g, '').trim()) && !hasNonGoalBullet) {
      errors.push({ code: 'MISSING_NON_GOALS', line: 1, message: '缺少「本期不做 / 非目标」节或内容为空', fixHint: '请写清本期明确不做的事项，防止范围蔓延。' })
    }
    const doorSec = findSectionByKeywords(sections, ['门型与回滚', '门型', '回滚路径'])
    const doorText = doorSec ? doorSec.body.replace(/<!--[\s\S]*?-->/g, '') : ''
    const hasInlineDoor = /\*\*门型(?:判定|与回滚路径)?\*\*[^\n]*\b(?:two-way|one-way)\b/i.test(bodyForSections)
    if ((!doorSec || !/\b(?:two-way|one-way)\b/i.test(doorText)) && !hasInlineDoor) {
      errors.push({ code: 'MISSING_DOOR_OR_ROLLBACK', line: 1, message: '缺少「门型与回滚路径」节，或未明确标注 two-way / one-way', fixHint: '请标注「门型：two-way」或「门型：one-way」，并写明具体回滚操作。' })
    }
  }

  const legacyCritique = /^(?:-\s+)?Plan Critique:\s*(.+)$/mi.exec(normRaw)?.[1]?.trim() ?? null
  const critiqueStatus = (typeof fm.data?.plan_critique === 'string' ? fm.data.plan_critique : null) ?? legacyCritique
  return { ok: errors.length === 0, file: relDoc, docType, critiqueStatus, errors, warnings }
}

export function collectMarkdownFiles(dir, root) {
  const out = []
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...collectMarkdownFiles(full, root))
    else if (entry.isFile() && entry.name.endsWith('.md')) out.push({ rel: posixPath(relative(root, full)), abs: full })
  }
  return out.sort((a, b) => a.rel.localeCompare(b.rel))
}

export function auditRepoDocs(repoRoot, scope = '.') {
  const scopeAbs = resolve(repoRoot, scope)
  const scopeRel = posixPath(relative(repoRoot, scopeAbs))
  const targets = []
  for (const d of ['docs/prd', 'docs/specs', 'docs/todo']) {
    const dirAbs = join(repoRoot, d)
    if (!existsSync(dirAbs)) continue
    for (const item of collectMarkdownFiles(dirAbs, repoRoot)) {
      if (!scopeRel || scopeRel === '.' || item.rel === scopeRel || item.rel.startsWith(`${scopeRel}/`)) targets.push(item.rel)
    }
  }
  const results = targets.map((file) => auditDoc({ repoRoot, file }))
  const failedCount = results.filter((r) => !r.ok).length
  return { ok: failedCount === 0, scope: scopeRel || '.', auditedCount: results.length, failedCount, results }
}

function summarizeDoc(item) {
  const text = readTextSafe(item.abs) ?? ''
  const fm = parseDocFrontmatter(text)
  const title = /^#\s+(.+)$/m.exec(fm.body || text)?.[1]?.trim() ?? fm.data?.title ?? basename(item.rel)
  return {
    file: item.rel,
    title,
    status: fm.data?.status ?? null,
    created: fm.data?.created ?? null,
    plannedAt: fm.data?.planned_at ?? null,
    issue: fm.data?.issue ?? null,
    pr: fm.data?.pr ?? null,
    totalChecks: (text.match(/^- \[[ xX]\]/gm) ?? []).length,
    doneChecks: (text.match(/^- \[[xX]\]/gm) ?? []).length,
  }
}

export function listDocs(repoRoot) {
  const tddPath = join(repoRoot, 'docs', 'TDD.md')
  return {
    tdd: existsSync(tddPath) ? summarizeDoc({ rel: 'docs/TDD.md', abs: tddPath }) : null,
    prds: collectMarkdownFiles(join(repoRoot, 'docs', 'prd'), repoRoot).map(summarizeDoc),
    specs: collectMarkdownFiles(join(repoRoot, 'docs', 'specs'), repoRoot).map(summarizeDoc),
    todos: collectMarkdownFiles(join(repoRoot, 'docs', 'todo'), repoRoot).map(summarizeDoc),
    archived: collectMarkdownFiles(join(repoRoot, 'docs', 'archive'), repoRoot).map(summarizeDoc),
  }
}
